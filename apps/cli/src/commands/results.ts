import { Args, Command } from "@oclif/core";
import { ConfigStore } from "../lib/config-store.js";

interface GradingResultPayload {
  id: string;
  submissionId: string;
  oneSheet: {
    overall_score: number;
    overall_grade: string;
    rubric_scores: Array<{ criterion: string; awarded_points: number; max_points: number }>;
    talking_points: Array<{ title: string; body: string }>;
  };
  sonarMetrics?: {
    complexity?: number;
    duplication_pct?: number;
    code_smells?: number;
    bugs?: number;
    coverage_pct?: number;
  } | null;
}

/**
 * kiln results <submissionId> — render the one-sheet with a Sonar summary.
 */
export default class Results extends Command {
  static override description = "Display grading results for a submission.";

  static override args = {
    submissionId: Args.string({
      description: "Submission id returned by `kiln submit`.",
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Results);
    const store = new ConfigStore();
    const config = await store.read();
    const apiUrl = config.apiUrl ?? process.env.KILN_API_URL ?? "http://localhost:4000";
    const token = config.authToken ?? process.env.KILN_TOKEN ?? "";

    const res = await fetch(`${apiUrl}/api/results/${args.submissionId}`, {
      headers: { authorization: token ? `Bearer ${token}` : "" },
    });
    if (!res.ok) {
      this.error(`results_failed: ${res.status} ${await res.text()}`);
    }
    const payload = (await res.json()) as GradingResultPayload;

    const os = payload.oneSheet;
    this.log("== KILN ONE-SHEET ==");
    this.log(`score: ${os.overall_score} (${os.overall_grade})`);
    this.log("rubric:");
    for (const r of os.rubric_scores) {
      this.log(`  - ${r.criterion}: ${r.awarded_points} / ${r.max_points}`);
    }
    this.log("talking points:");
    for (const tp of os.talking_points) {
      this.log(`  * ${tp.title}`);
      this.log(`      ${tp.body}`);
    }
    if (payload.sonarMetrics) {
      const s = payload.sonarMetrics;
      this.log(
        `sonar: complexity=${s.complexity ?? "?"} duplication=${s.duplication_pct ?? "?"}% bugs=${s.bugs ?? "?"} smells=${s.code_smells ?? "?"} coverage=${s.coverage_pct ?? "?"}%`,
      );
    }
  }
}
