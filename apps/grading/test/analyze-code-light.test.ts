import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeCodeLight } from "../src/activities/analyze-code-light.js";

const SONAR_URL = "http://sonar.test";

describe("analyzeCodeLight hybrid flow", () => {
  beforeEach(() => {
    process.env.MOCK_LLM = "1";
    process.env.SONAR_URL = SONAR_URL;
    process.env.SONAR_TOKEN = "faketoken";
    nock.cleanAll();
  });
  afterEach(() => {
    nock.cleanAll();
  });

  it("uses a `checkpoint-<id>` project key (not submission-<id>)", async () => {
    const submissionId = "00000000-0000-0000-0000-000000000010";
    const deleteScope = nock(SONAR_URL)
      .get("/api/measures/component")
      .query((q) => q.component === `checkpoint-${submissionId}`)
      .reply(200, {
        component: {
          key: `checkpoint-${submissionId}`,
          measures: [
            { metric: "complexity", value: "3" },
            { metric: "code_smells", value: "2" },
            { metric: "coverage", value: "80.0" },
            { metric: "ncloc", value: "200" },
            { metric: "sqale_rating", value: "1" },
            { metric: "reliability_rating", value: "1" },
            { metric: "security_rating", value: "1" },
            { metric: "bugs", value: "0" },
            { metric: "vulnerabilities", value: "0" },
            { metric: "duplicated_lines_density", value: "0" },
          ],
        },
      })
      .post("/api/projects/delete")
      .query((q) => q.project === `checkpoint-${submissionId}`)
      .reply(204);

    const result = await analyzeCodeLight({
      workspacePath: "/tmp/ignored",
      submissionId,
      cohortId: "cohort-1",
      rubricYaml: "name: mock\nversion: 1\ncriteria: []",
      testResults: {
        visible: [],
        hidden: null,
        testSuitesPassed: 1,
        testSuitesFailed: 0,
      },
    });

    expect(result.sonarMetrics).not.toBeNull();
    expect(result.sonarMetrics?.project_key).toBe(`checkpoint-${submissionId}`);
    // Single LLM call only — no 3-pass pipeline.
    expect(result.llmCallDetails).toHaveLength(1);
    expect(result.llmCallDetails[0]?.purpose).toBe("checkpoint-code-analysis");
    expect(result.llmCallDetails[0]?.model).toContain("sonnet");

    // Ensure the delete endpoint was actually hit (project cleanup).
    expect(deleteScope.isDone()).toBe(true);
  });

  it("tolerates null testResults (checkpoint best-effort)", async () => {
    const submissionId = "00000000-0000-0000-0000-000000000011";
    delete process.env.SONAR_TOKEN; // force sonar null path

    const result = await analyzeCodeLight({
      workspacePath: "/tmp/ignored",
      submissionId,
      cohortId: "cohort-1",
      rubricYaml: "",
      testResults: null,
    });

    expect(result.sonarMetrics).toBeNull();
    expect(result.llmCallDetails).toHaveLength(1);
    expect(result.llmCallDetails[0]?.purpose).toBe("checkpoint-code-analysis");
  });
});
