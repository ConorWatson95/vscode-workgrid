import { describe, expect, it } from "vitest";
import {
  RULE_CONFIRM_THRESHOLD,
  describeRuleAdditions,
  needsRuleConfirmation,
} from "./ruleConfirmation";
import { TaskStage } from "./taskPipeline";
import { RuleMatch } from "./reviewRules";

const stage = (id: string, name: string): TaskStage =>
  ({ id, name, kind: "domainReview", status: "pending", subtasks: [] }) as TaskStage;

const match = (stageId: string, reason: string, paths: string[]): RuleMatch =>
  ({
    rule: { id: stageId, reason, when: {}, stage: { id: stageId } },
    matchedPaths: paths,
  }) as RuleMatch;

describe("needsRuleConfirmation", () => {
  it("does not ask for the ordinary case", () => {
    // A SQL change obliging a SQL review is the design working. Interrupting for it
    // would train the reflex of clicking through, which is what makes the fifth one
    // dangerous.
    expect(needsRuleConfirmation([stage("a", "A")])).toBe(false);
    expect(
      needsRuleConfirmation(
        Array.from({ length: RULE_CONFIRM_THRESHOLD }, (_, i) => stage(`s${i}`, "S")),
      ),
    ).toBe(false);
  });

  it("asks once the count is more than the threshold", () => {
    expect(
      needsRuleConfirmation(
        Array.from({ length: RULE_CONFIRM_THRESHOLD + 1 }, (_, i) => stage(`s${i}`, "S")),
      ),
    ).toBe(true);
  });

  it("does not ask when nothing is being added", () => {
    expect(needsRuleConfirmation([])).toBe(false);
  });
});

describe("describeRuleAdditions", () => {
  it("gives the evidence, not just the count", () => {
    // "Add 5 reviews?" is unanswerable. "ETL review, because 412 paths matched" is a
    // question with an obvious answer when the paths are wrong.
    const text = describeRuleAdditions(
      [stage("r-etl", "ETL reliability review")],
      [match("r-etl", "ETL touched", ["tools/etl/a.sql", "tools/etl/b.sql"])],
    );
    expect(text).toContain("ETL reliability review");
    expect(text).toContain("ETL touched");
    expect(text).toContain("2 path(s)");
    expect(text).toContain("tools/etl/a.sql");
  });

  it("still describes a stage whose match cannot be found", () => {
    // Never blank: a stage listed with no reason is one the reader cannot judge.
    const text = describeRuleAdditions([stage("r-x", "Mystery review")], []);
    expect(text).toContain("Mystery review");
    expect(text).toContain("a rule matched");
  });
});
