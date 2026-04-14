/**
 * Gold-set loader — reads `manifest.json`, resolves per-submission fixture
 * files, parses rubric YAML via the shared `RubricSchema`, and hands the
 * regression test a ready-to-consume array.
 *
 * The raw JSON manifest is intentionally small and human-editable. The
 * heavier per-submission fixture files (code, logs, transcript, test
 * results) live under `submissions/<id>/` and are hydrated lazily by the
 * loader. Shipping a loader function (rather than a pre-built object)
 * keeps the tree ergonomic and avoids stale checked-in derived data.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Rubric, RubricSchema } from "@kiln/shared";
import yaml from "js-yaml";

export type ExpectedScores = {
  Ships: number;
  Resilience: number;
  CodeCraft: number;
  AiUsage: number;
  Communication: number;
};

export interface GoldSetSubmission {
  id: string;
  cohortName: string;
  weekNumber: number;
  rubric: Rubric;
  rubricYaml: string;
  rubricVersion: string;
  grader: string;
  gradedAt: string;
  stage: "early" | "final";
  codeFiles: Record<string, string>;
  normalizedLogs: {
    entryCount: number;
    byKind: Record<string, number>;
    toolUses: number;
    gaps: string[];
  };
  videoTranscript: string;
  testResults: {
    visibleCount: number;
    hiddenCount: number | null;
    testSuitesPassed: number;
    testSuitesFailed: number;
  };
  expectedScores: ExpectedScores;
}

interface ManifestEntry {
  id: string;
  cohortName: string;
  weekNumber: number;
  rubric: string;
  rubricVersion: string;
  grader: string;
  graded_at: string;
  stage?: "early" | "final";
  expected_scores: ExpectedScores;
}

interface Manifest {
  version: string;
  generated_at: string;
  submissions: ManifestEntry[];
}

const __filename = fileURLToPath(import.meta.url);
const GOLD_SET_DIR = dirname(__filename);

async function readJson<T>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as T;
}

async function readCodeFiles(dir: string): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const out: Record<string, string> = {};
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      const abs = join(dir, name);
      out[name] = await readFile(abs, "utf8");
    }
  } catch {
    // empty code_files dir
  }
  return out;
}

export async function loadGoldSet(): Promise<{ submissions: GoldSetSubmission[] }> {
  const manifest = await readJson<Manifest>(join(GOLD_SET_DIR, "manifest.json"));
  const submissions: GoldSetSubmission[] = [];

  const rubricCache = new Map<string, { rubric: Rubric; yamlText: string }>();

  for (const entry of manifest.submissions) {
    if (!rubricCache.has(entry.rubric)) {
      const rubricPath = join(GOLD_SET_DIR, "rubrics", entry.rubric);
      const yamlText = await readFile(rubricPath, "utf8");
      const parsed = yaml.load(yamlText);
      const rubric = RubricSchema.parse(parsed);
      rubricCache.set(entry.rubric, { rubric, yamlText });
    }
    const { rubric, yamlText } = rubricCache.get(entry.rubric) ?? {
      rubric: {
        name: "missing",
        version: "0",
        criteria: [{ key: "k", label: "k", weight: 1, max_points: 1 }],
      },
      yamlText: "",
    };

    const subDir = join(GOLD_SET_DIR, "submissions", entry.id);
    const codeFiles = await readCodeFiles(join(subDir, "code_files"));
    const normalizedLogs = await readJson<GoldSetSubmission["normalizedLogs"]>(
      join(subDir, "normalized_logs.json"),
    );
    const videoTranscript = await readFile(join(subDir, "video_transcript.txt"), "utf8");
    const rawTestResults = await readJson<{
      visible: Array<{ id: string; verdict: string; duration_ms: number }>;
      hidden: Array<{ id: string; verdict: string; duration_ms: number }> | null;
      testSuitesPassed: number;
      testSuitesFailed: number;
    }>(join(subDir, "test_results.json"));

    submissions.push({
      id: entry.id,
      cohortName: entry.cohortName,
      weekNumber: entry.weekNumber,
      rubric,
      rubricYaml: yamlText,
      rubricVersion: entry.rubricVersion,
      grader: entry.grader,
      gradedAt: entry.graded_at,
      stage: entry.stage ?? "final",
      codeFiles,
      normalizedLogs,
      videoTranscript,
      testResults: {
        visibleCount: rawTestResults.visible.length,
        hiddenCount: rawTestResults.hidden?.length ?? null,
        testSuitesPassed: rawTestResults.testSuitesPassed,
        testSuitesFailed: rawTestResults.testSuitesFailed,
      },
      expectedScores: entry.expected_scores,
    });
  }

  return { submissions };
}
