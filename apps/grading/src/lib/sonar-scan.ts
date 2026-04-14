import { type SonarMetrics, SonarMetricsSchema } from "@kiln/shared";

/**
 * Shared SonarQube scan helper.
 *
 * Both the full grading pipeline (`analyzeCode`) and the reduced checkpoint
 * pipeline (`analyzeCodeLight`) call this. Each caller picks its own
 * projectKey so the two pipelines never stomp on each other inside
 * SonarQube.
 *
 * DEFERRED: real `sonar-scanner` CLI invocation. For MVP we probe the
 * SonarQube REST API and accept `null` metrics when the project isn't
 * analyzed or the infra is unreachable — the downstream LLM handles the
 * "no Sonar data" case.
 */

const DEFAULT_SONAR_URL = "http://localhost:9000";

const SONAR_METRIC_KEYS = [
  "complexity",
  "cognitive_complexity",
  "duplicated_lines_density",
  "code_smells",
  "bugs",
  "vulnerabilities",
  "security_hotspots",
  "coverage",
  "ncloc",
  "sqale_rating",
  "reliability_rating",
  "security_rating",
].join(",");

export interface SonarScanResult {
  metrics: SonarMetrics | null;
  scanDurationMs: number;
  projectKey: string;
}

/**
 * Fetch SonarQube metrics for a workspace via its REST API, then delete the
 * ephemeral project. Accepts a pre-computed project key so callers can keep
 * their pipelines isolated (grading = `submission-<id>`, checkpoint =
 * `checkpoint-<id>`).
 *
 * @param _workspacePath currently unused — kept in the signature so a future
 * refactor that invokes `sonar-scanner` against the checkout path stays
 * API-compatible.
 */
export async function scanWorkspace(
  _workspacePath: string,
  projectKey: string,
): Promise<SonarScanResult> {
  const start = Date.now();
  const metrics = await fetchMetrics(projectKey);
  return {
    metrics,
    scanDurationMs: Date.now() - start,
    projectKey,
  };
}

async function fetchMetrics(projectKey: string): Promise<SonarMetrics | null> {
  const baseUrl = process.env.SONAR_URL ?? DEFAULT_SONAR_URL;
  const token = process.env.SONAR_TOKEN;
  if (!token) {
    // No SONAR_TOKEN configured — skip cleanly.
    return null;
  }
  const authHeader = `Basic ${Buffer.from(`${token}:`).toString("base64")}`;
  try {
    const url = new URL(`${baseUrl}/api/measures/component`);
    url.searchParams.set("component", projectKey);
    url.searchParams.set("metricKeys", SONAR_METRIC_KEYS);
    const res = await fetch(url, { headers: { Authorization: authHeader } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      component?: { measures?: Array<{ metric: string; value: string }> };
    };
    const measures = json.component?.measures ?? [];
    const byKey = new Map<string, string>();
    for (const m of measures) byKey.set(m.metric, m.value);
    const num = (k: string): number => Number(byKey.get(k) ?? "0");
    const rating = (k: string): SonarMetrics["sqale_rating"] => {
      const n = Number(byKey.get(k) ?? "1");
      return (["A", "B", "C", "D", "E"] as const)[Math.min(4, Math.max(0, n - 1))] ?? "A";
    };
    const metrics: SonarMetrics = SonarMetricsSchema.parse({
      project_key: projectKey,
      analyzed_at: new Date().toISOString(),
      complexity: num("complexity"),
      cognitive_complexity: num("cognitive_complexity") || undefined,
      duplication_pct: num("duplicated_lines_density"),
      code_smells: num("code_smells"),
      bugs: num("bugs"),
      vulnerabilities: num("vulnerabilities"),
      security_hotspots: num("security_hotspots") || undefined,
      coverage_pct: num("coverage"),
      lines_of_code: num("ncloc") || undefined,
      sqale_rating: rating("sqale_rating"),
      maintainability_rating: rating("sqale_rating"),
      reliability_rating: rating("reliability_rating"),
      security_rating: rating("security_rating"),
    });

    // Best-effort cleanup — the project may already be gone or not exist.
    await fetch(`${baseUrl}/api/projects/delete?project=${projectKey}`, {
      method: "POST",
      headers: { Authorization: authHeader },
    }).catch(() => {
      // ignore
    });

    return metrics;
  } catch {
    return null;
  }
}
