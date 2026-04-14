import type { ChaosResult, LLMCallDetail, OneSheet, SonarMetrics } from "@kiln/shared";

// ---------- clone ----------
export interface CloneRepoInput {
  submissionId: string;
  repoUrl: string;
  commitSha: string;
}

export interface CloneRepoResult {
  workspacePath: string;
  gitCloneDurationMs: number;
}

// ---------- build-docker ----------
export interface BuildDockerInput {
  workspacePath: string;
  submissionId: string;
}

export type BuildDockerResult =
  | {
      status: "ok";
      dockerBuildDurationMs: number;
      imageRef: string;
    }
  | {
      status: "missing";
      reason: string;
      affectedCriteria: string[];
      dockerBuildDurationMs?: number;
    }
  | {
      status: "failed";
      exitCode: number;
      logsTail: string;
      affectedCriteria: string[];
      dockerBuildDurationMs?: number;
    };

// ---------- run-tests ----------
export interface RunTestsInput {
  workspacePath: string;
  submissionId: string;
  visibleChaosYaml: string;
  hiddenChaosYaml: string;
  stage: "early" | "final";
  buildStatus: BuildDockerResult["status"];
}

export interface RunTestsResult {
  visible: ChaosResult[];
  hidden: ChaosResult[] | null;
  testSuitesPassed: number;
  testSuitesFailed: number;
}

// ---------- normalize-logs ----------
export interface NormalizeLogsInput {
  workspacePath: string;
}

export interface NormalizedLogs {
  entryCount: number;
  byKind: Record<string, number>;
  toolUses: number;
  gaps: string[];
}

// ---------- analyze-code ----------
export interface AnalyzeCodeInput {
  workspacePath: string;
  submissionId: string;
  cohortId: string;
  rubricYaml: string;
  testResults: RunTestsResult;
}

export interface AnalyzeCodeResult {
  sonarMetrics: SonarMetrics | null;
  sonarqubeScanDurationMs: number;
  llmFeedback: string;
  llmCallDetails: LLMCallDetail[];
}

// ---------- generate-one-sheet ----------
export interface GenerateOneSheetInput {
  submissionId: string;
  cohortId: string;
  weekId: string;
  userId: string;
  stage: "early" | "final";
  rubricYaml: string;
  normalizedLogs: NormalizedLogs;
  codeAnalysis: AnalyzeCodeResult;
  testResults: RunTestsResult;
  buildResult: BuildDockerResult;
}

export interface GenerateOneSheetResult {
  oneSheet: OneSheet;
  rubricVersion: string;
  promptVersion: string;
  modelVersion: string;
  llmCallDetails: LLMCallDetail[];
}

// ---------- store-results ----------
export interface StoreResultsInput {
  submissionId: string;
  cohortId: string;
  weekId: string;
  userId: string;
  stage: "early" | "final";
  rubricYaml: string;
  oneSheet: OneSheet;
  sonarMetrics: SonarMetrics | null;
  llmCallDetails: LLMCallDetail[];
  durations: {
    gitCloneMs: number;
    dockerBuildMs: number;
    sonarqubeScanMs: number;
  };
  pipelineStartedAt: string;
  rubricVersion: string;
  promptVersion: string;
  modelVersion: string;
}

export interface StoreResultsResult {
  gradingResultId: string;
  oneSheetArtifactPath: string;
  usageEventId: string;
  /**
   * Phase 7.5: signals the workflow to kick off `dispatchArtifacts` as a
   * child with ParentClosePolicy.ABANDON. Activities cannot start child
   * workflows themselves, so the workflow consults this flag.
   */
  shouldDispatch: boolean;
}
