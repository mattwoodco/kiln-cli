import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import { analyzeCode } from "../src/activities/analyze-code.js";

const SONAR_URL = "http://sonar.test";

describe("analyzeCode hybrid flow", () => {
  beforeEach(() => {
    process.env.MOCK_LLM = "1";
    process.env.SONAR_URL = SONAR_URL;
    process.env.SONAR_TOKEN = "faketoken";
    nock.cleanAll();
  });
  afterEach(() => {
    nock.cleanAll();
  });

  it("parses Sonar measures into SonarMetrics and records an LLM call detail", async () => {
    const submissionId = "00000000-0000-0000-0000-000000000001";
    nock(SONAR_URL)
      .get("/api/measures/component")
      .query(true)
      .reply(200, {
        component: {
          key: `submission-${submissionId}`,
          measures: [
            { metric: "complexity", value: "12" },
            { metric: "duplicated_lines_density", value: "3.5" },
            { metric: "code_smells", value: "7" },
            { metric: "bugs", value: "1" },
            { metric: "vulnerabilities", value: "0" },
            { metric: "coverage", value: "67.2" },
            { metric: "ncloc", value: "840" },
            { metric: "sqale_rating", value: "2" },
            { metric: "reliability_rating", value: "1" },
            { metric: "security_rating", value: "1" },
          ],
        },
      })
      .post("/api/projects/delete")
      .query(true)
      .reply(204);

    const result = await analyzeCode({
      workspacePath: "/tmp/ignored",
      submissionId,
      cohortId: "cohort-1",
      rubricYaml: "name: Mock\nversion: 1\ncriteria:\n  - key: ships\n",
      testResults: {
        visible: [],
        hidden: null,
        testSuitesPassed: 1,
        testSuitesFailed: 0,
      },
    });

    expect(result.sonarMetrics).not.toBeNull();
    expect(result.sonarMetrics?.complexity).toBe(12);
    expect(result.sonarMetrics?.code_smells).toBe(7);
    expect(result.sonarMetrics?.coverage_pct).toBeCloseTo(67.2, 1);
    expect(result.sonarMetrics?.sqale_rating).toBe("B");
    expect(result.llmCallDetails).toHaveLength(1);
    expect(result.llmCallDetails[0]?.purpose).toBe("analyze-code");
    expect(result.llmCallDetails[0]?.estimated_cost_usd).toBeGreaterThan(0);
  });

  it("returns null sonarMetrics when SONAR_TOKEN is absent", async () => {
    delete process.env.SONAR_TOKEN;
    const result = await analyzeCode({
      workspacePath: "/tmp/ignored",
      submissionId: "00000000-0000-0000-0000-000000000002",
      cohortId: "cohort-1",
      rubricYaml: "",
      testResults: {
        visible: [],
        hidden: null,
        testSuitesPassed: 0,
        testSuitesFailed: 0,
      },
    });
    expect(result.sonarMetrics).toBeNull();
    expect(result.llmCallDetails).toHaveLength(1);
  });
});
